#!/usr/bin/env node
// Alias so `bunx samesake …` works: @samesake/cli's entry executes on import
// (its dist runs main() at top level and reads process.argv from this process).
import "@samesake/cli";
