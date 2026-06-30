// Netlify Function wrapper for the Express API.
// Path: /.netlify/functions/api/*  is redirected to /api/*  via netlify.toml
const serverless = require('serverless-http');
const app = require('../../api/index.js');

// serverless-http converts Express -> AWS Lambda handler
// Netlify Functions use the same Lambda API
const handler = serverless(app, {
  basePath: '/api',
});

exports.handler = async (event, context) => {
  // Netlify sometimes mutates path; ensure /api prefix
  if (event.path && !event.path.startsWith('/api')) {
    if (event.path.startsWith('/.netlify/functions/api')) {
      event.path = '/api' + event.path.replace('/.netlify/functions/api', '');
    }
  }
  return handler(event, context);
};
