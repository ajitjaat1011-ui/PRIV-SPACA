// Minimal local dev harness: serves static frontend + mounts the real Express
// API app (which already defines routes as /api/...) at the root.
const path = require('path');
const express = require('express');
const apiApp = require(path.join(__dirname, 'api', 'index.js'));

const server = express();
server.use(apiApp); // apiApp's own routes are /api/*, so mount at root
server.use(express.static(__dirname));
server.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = 8787;
server.listen(PORT, () => console.log('Dev server on :' + PORT));
