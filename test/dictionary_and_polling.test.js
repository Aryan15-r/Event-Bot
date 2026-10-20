import test from 'node:test';
import assert from 'node:assert/strict';
import { pollChannel } from '../src/sentinel/services/polling.js';
import { listAllChannels, updateChannelMonitoring, upsertMessages } from '../src/sentinel/db/queries.js';

test('pollChannel: forces initial backfill (limit 50, no after) when channel has no cursor', async () => {
  const preparedCalls = [];
  const clientCalls = [];

  const mockDb = {
    prepare(sql) {
      return {
        bind(...args) {
          preparedCalls.push({ sql, args });
          return {
            async first(col) {
              if (sql.includes('SELECT message_id FROM messages WHERE channel_id = ? LIMIT 1')) {
                return null; // 0 local messages!
              }
              return null;
            },
            async run() {
              return { success: true };
            },
            async all() {
              return { results: [] };
            }
          };
        }
      };
    },
    async batch() {
      return [];
    }
  };

  const mockClient = {
    async getChannelMessages(channelId, options) {
      clientCalls.push({ channelId, options });
      return [
        {
          id: '1500000000000000001',
          content: 'Hello world from Discord',
          author: { id: 'user1', username: 'alice' },
          timestamp: '2026-10-20T10:00:00Z'
        }
      ];
    }
  };

  const channel = {
    channel_id: 'ch_newly_added',
    guild_id: 'guild1',
    // Never polled before: no cursor stored anywhere.
    last_message_id: null,
    cursor_message_id: null
  };

  const result = await pollChannel(mockDb, mockClient, channel);

  assert.equal(result.success, true);
  assert.equal(clientCalls.length, 1);
  assert.equal(clientCalls[0].channelId, 'ch_newly_added');
  // It must NOT query with `after`, but must query with initial backfill `limit: 50`
  assert.equal(clientCalls[0].options.after, undefined);
  assert.equal(clientCalls[0].options.limit, 50);
});

test('pollChannel: keeps using the cursor even when local messages were pruned', async () => {
  const clientCalls = [];

  const mockDb = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('SELECT message_id FROM messages WHERE channel_id = ? LIMIT 1')) {
                return null; // messages were pruned by retention
              }
              return null;
            },
            async run() {
              return { success: true };
            },
            async all() {
              return { results: [] };
            }
          };
        }
      };
    },
    async batch() {
      return [];
    }
  };

  const mockClient = {
    async getChannelMessages(channelId, options) {
      clientCalls.push({ channelId, options });
      return [];
    }
  };

  const channel = {
    channel_id: 'ch_pruned',
    guild_id: 'guild1',
    cursor_message_id: '1500000000000000001'
  };

  const result = await pollChannel(mockDb, mockClient, channel);

  assert.equal(result.success, true);
  assert.equal(clientCalls.length, 1);
  // Must stay incremental — re-running a 50 message backfill every poll
  // exhausted the D1 rows-written quota.
  assert.equal(clientCalls[0].options.after, '1500000000000000001');
});

test('pollChannel: uses cursor with after when channel already has local messages in DB', async () => {
  const clientCalls = [];

  const mockDb = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('SELECT message_id FROM messages WHERE channel_id = ? LIMIT 1')) {
                return { message_id: '1500000000000000001' }; // Has messages in DB!
              }
              return null;
            },
            async run() {
              return { success: true };
            },
            async all() {
              return { results: [] };
            }
          };
        }
      };
    },
    async batch() {
      return [];
    }
  };

  const mockClient = {
    async getChannelMessages(channelId, options) {
      clientCalls.push({ channelId, options });
      return []; // Caught up
    }
  };

  const channel = {
    channel_id: 'ch_existing',
    guild_id: 'guild1',
    cursor_message_id: '1500000000000000001'
  };

  const result = await pollChannel(mockDb, mockClient, channel);

  assert.equal(result.success, true);
  assert.equal(clientCalls.length, 1);
  assert.equal(clientCalls[0].options.after, '1500000000000000001');
});

test('upsertMessages: skips writing when the stored message is unchanged', async () => {
  const executedSql = [];
  // A batch result with changes === 0 means the conditional ON CONFLICT
  // DO UPDATE ... WHERE matched nothing, so D1 wrote no row.
  const mockDb = {
    prepare(sql) {
      executedSql.push(sql);
      return {
        bind(...args) {
          return {
            async first() { return null; },
            async run() { return { success: true, meta: { changes: 1 } }; },
            async all() { return { results: [] }; }
          };
        }
      };
    },
    async batch(chunk) {
      // Both rows are already stored with identical content.
      return chunk.map(() => ({ meta: { changes: 0 } }));
    }
  };

  const result = await upsertMessages(mockDb, [
    { id: 'm1', guild_id: 'g1', channel_id: 'c1', author: { id: 'u1', username: 'alice' }, content: 'same' },
    { id: 'm2', guild_id: 'g1', channel_id: 'c1', author: { id: 'u1', username: 'alice' }, content: 'same too' }
  ]);

  assert.equal(result.inserted, 0);
  assert.equal(result.unchanged, 2);
  // The upsert must be conditional, otherwise every re-fetch rewrites the row.
  assert.match(executedSql[0], /DO UPDATE SET[\s\S]*WHERE[\s\S]*IFNULL\(messages\.content/);
});

test('listAllChannels: respects monitoredOnly filter flag', async () => {
  let executedSql = '';
  let boundArgs = [];

  const mockDb = {
    prepare(sql) {
      executedSql = sql;
      return {
        bind(...args) {
          boundArgs = args;
          return {
            async all() {
              return {
                results: [
                  { channel_id: 'c1', name: 'general', is_monitored: 1 }
                ]
              };
            }
          };
        }
      };
    }
  };

  const channels = await listAllChannels(mockDb, 'guild_test', true);
  assert.equal(channels.length, 1);
  assert.match(executedSql, /c\.is_monitored = 1/);
  assert.match(executedSql, /c\.guild_id = \?/);
  assert.deepEqual(boundArgs, ['guild_test']);
});

test('updateChannelMonitoring: clears stale cursor when enabling a channel with 0 messages', async () => {
  const executedStatements = [];

  const mockDb = {
    prepare(sql) {
      return {
        bind(...args) {
          executedStatements.push({ sql, args });
          return {
            async first() {
              if (sql.includes('SELECT message_id FROM messages')) {
                return null; // 0 messages
              }
              return null;
            },
            async run() {
              return { success: true };
            }
          };
        }
      };
    }
  };

  await updateChannelMonitoring(mockDb, 'ch_fresh', true);

  const deleteCursorStmt = executedStatements.find(s => s.sql.includes('DELETE FROM channel_cursors'));
  assert.ok(deleteCursorStmt, 'Must delete stale channel cursor if 0 messages exist in DB');
  assert.deepEqual(deleteCursorStmt.args, ['ch_fresh']);

  const resetLastMessageStmt = executedStatements.find(s => s.sql.includes('UPDATE channels SET last_message_id = NULL'));
  assert.ok(resetLastMessageStmt, 'Must clear last_message_id on channels table');
  assert.deepEqual(resetLastMessageStmt.args, ['ch_fresh']);
});
