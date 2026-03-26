#!/usr/bin/env node
const { main } = require('./skills_store_cli');

main(process.argv.slice(2)).catch((error) => {
  const message = error?.message || String(error);
  if (message) {
    console.error(`Error: ${message}`);
  }
  process.exit(error?.exitCode || 1);
});
