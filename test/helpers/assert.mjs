/** Minimal zero-dependency test harness shared by all test files. */

function safe(v) {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function harness(title) {
  const state = { passed: 0, failed: 0, failures: [] };

  const check = (name, cond, extra) => {
    if (cond) {
      state.passed++;
      console.log(`  PASS  ${name}`);
    } else {
      state.failed++;
      state.failures.push(name);
      console.error(`  FAIL  ${name}${extra !== undefined ? ` -> ${safe(extra)}` : ""}`);
    }
  };

  const section = (t) => console.log(`\n=== ${t} ===`);

  const done = () => {
    console.log(`\n${title}: ${state.passed} passed, ${state.failed} failed`);
    if (state.failed > 0) {
      console.error(`${title} FAILURES: ${state.failures.join(", ")}`);
      process.exitCode = 1;
    }
    return state;
  };

  console.log(`\n##### ${title} #####`);
  return { check, section, done, state };
}

/** Assert that an async fn throws, returning the thrown error. */
export async function expectThrows(fn) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return null;
}
