// src/ui/html.js
// Server-rendered HTML dashboard shell with security attributes and metadata

import { getSecurityHeaders } from '../utils/security.js';

export function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="Sentinel — Secure Read-Only Discord Monitoring Platform and Archiver">
  <meta name="theme-color" content="#0B0E14">
  <title>SENTINEL — Discord Monitoring Platform</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div id="app-root"></div>
  <script src="/app.js"></script>
</body>
</html>`;
}

/**
 * Returns response with full security headers for the dashboard HTML shell.
 */
export function handleDashboardPage() {
  return new Response(renderDashboardHtml(), {
    status: 200,
    headers: getSecurityHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    })
  });
}
