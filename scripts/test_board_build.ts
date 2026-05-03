/**
 * E2E test for the custom-board flow without spinning up the server/UI.
 * Loads .env, calls buildCustomBoard with a tiny synthetic profile, prints
 * a summary of the returned GameDef.
 */
import "dotenv/config";
import { buildCustomBoard } from "../src/board_builder.js";
import { describeBackend } from "../src/llm.js";

async function main() {
  console.log(`backend: ${describeBackend()}`);
  const profiles = [
    {
      name: "Mat",
      transcript:
        "I'm into chemistry, linear algebra, anything Greenwich Connecticut, anything Princeton, late 90s and early 2000s tech history, classical guitar, and Formula 1.",
    },
    {
      name: "Sam",
      transcript:
        "I'm good at 90s and 2000s pop music, Marvel movies, NBA history, and US presidents.",
    },
  ];
  const t0 = Date.now();
  const def = await buildCustomBoard(profiles);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== built "${def.title}" in ${elapsed}s ===\n`);

  console.log("Round 1 (Jeopardy):");
  for (const c of def.rounds[0].categories) {
    console.log(`  ${c.title}`);
    for (const q of c.clues) {
      const dd = q.dailyDouble ? " [DD]" : "";
      console.log(`    $${q.value}${dd}: ${q.prompt}`);
      console.log(`      → ${q.answer}`);
    }
  }
  console.log("\nRound 2 (Double Jeopardy):");
  for (const c of def.rounds[1].categories) {
    console.log(`  ${c.title}`);
    for (const q of c.clues) {
      const dd = q.dailyDouble ? " [DD]" : "";
      console.log(`    $${q.value}${dd}: ${q.prompt}`);
      console.log(`      → ${q.answer}`);
    }
  }
  console.log("\nFinal Jeopardy:");
  console.log(`  Category: ${def.final.category}`);
  console.log(`  Prompt: ${def.final.prompt}`);
  console.log(`  Answer: ${def.final.answer}`);

  // Sanity checks
  if (def.rounds[0].categories.length !== 6) throw new Error("R1 not 6 cats");
  if (def.rounds[1].categories.length !== 6) throw new Error("R2 not 6 cats");
  for (const round of def.rounds) {
    for (const cat of round.categories) {
      if (cat.clues.length !== 5)
        throw new Error(`Cat "${cat.title}" not 5 clues`);
    }
  }
  console.log("\nshape ok ✓");
}

main().catch((err) => {
  console.error("test failed:", err);
  process.exit(1);
});
