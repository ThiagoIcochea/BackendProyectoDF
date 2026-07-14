const assert = require("assert");
const { analyzeReportWithGroq } = require("../utils/supportBot");

(async () => {
  // Caso de prueba 1: sin mensajes
  const resEmpty = await analyzeReportWithGroq("Spamming", []);
  assert.strictEqual(resEmpty.allowed, true);
  assert.strictEqual(resEmpty.block, false);
  assert.strictEqual(resEmpty.reason, "El usuario no envió mensajes hoy para ser evaluados.");

  console.log("chatReportModeration empty messages test passed");
})();
