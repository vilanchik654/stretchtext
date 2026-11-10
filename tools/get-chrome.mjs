import fs from "node:fs";
import path from "node:path";
const url = "https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.50/win64/chrome-win64.zip";
const out = path.resolve("test/.artifacts/chrome-win64.zip");
fs.mkdirSync(path.dirname(out), { recursive: true });
const t0 = Date.now();
for (let attempt = 1; attempt <= 5; attempt++) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(600000) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    let got = 0;
    const file = fs.createWriteStream(out);
    for await (const chunk of res.body) { got += chunk.length; file.write(chunk); }
    await new Promise((r) => file.end(r));
    console.log("downloaded", (got / 1e6).toFixed(1), "MB in", ((Date.now() - t0) / 1000).toFixed(1), "s");
    process.exit(0);
  } catch (e) {
    console.log("attempt", attempt, "failed:", e.message);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}
process.exit(1);
