#!/usr/bin/env node
import { main } from "../src/main.js";

process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});
main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
