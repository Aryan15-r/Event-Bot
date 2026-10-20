local HttpService = game:GetService("HttpService")

local API_URL = "https://discord-event-bot.tgia.workers.dev/roblox/event"
local SECRET = "AUDITS_TGIA-secret"

if not game.ServerStorage:FindFirstChild("EventHosted") then
	local flag = Instance.new("BoolValue")
	flag.Name = "EventHosted"
	flag.Value = false -- done
	flag.Parent = game.ServerStorage
end

local EventFlag = game.ServerStorage.EventHosted

return function(context, eventType, startTime, coHost, supervisor, private_Link, note)

	local executor = context.Executor

	if EventFlag.Value == true then
		return "❌ An event is already being hosted."
	end

	if executor:GetRankInGroup(14720761) < 100 then
		return "❌ You do not have permission."
	end

	local payload = {
		key = SECRET,
		ts = os.time(),
		playerId = executor.UserId,
		playerName = executor.Name,
		event_type = eventType,
		starts_at = startTime,
		co_host = coHost, -- Added
		supervisor = supervisor, -- Added
		private_server_link = private_Link,
		note = note or "Hosted from Roblox",
		guild_id = "1429172254981492798",
	}

	local success, err = pcall(function()
		HttpService:PostAsync(
			API_URL,
			HttpService:JSONEncode(payload),
			Enum.HttpContentType.ApplicationJson
		)
	end)

	if not success then
		warn(err)
		return "❌ Failed to send event."
	end

	EventFlag.Value = true
	return "✅ Event created successfully."
end

------------------------------ś̷̋̃̌ḵ̷̢̖̀ī̴̓̅͝b̴̏̿̓̓ī̸̈́̅̾d̸̮̓̍̓i
-- a̾̾̾̾̾҈҈҈҈҈҈҈꙲꙲̈́̈́̈́̈́̈́