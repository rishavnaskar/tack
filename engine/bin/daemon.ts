#!/usr/bin/env node
/** Daemon entry point. Normally started on demand by the CLI. */
import { Daemon } from '../src/daemon/server.ts';

const daemon = new Daemon({ headless: process.env.BA_HEADLESS === '1' });
await daemon.start();
