/**
 * PRIV SPACA — Hono app instance
 *
 * Created in its own module so route modules and the entry point can share it
 * without a circular import.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { Hono } from 'hono';

export const app = new Hono();
