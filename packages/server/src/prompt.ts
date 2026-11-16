/**
 * Questions at a terminal, and answers piped in. At a terminal a secret is
 * typed unseen. With input piped in (a script, a container build), every
 * line is read first and handed out one per question, because a line reader
 * takes all of the input the moment it is asked once.
 */

import { createInterface } from "node:readline";

let piped: Promise<string[]> | null = null;

function pipedLines(): Promise<string[]> {
  piped ??= new Promise((done) => {
    const lines: string[] = [];
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (l) => lines.push(l));
    rl.on("close", () => done(lines));
  });
  return piped;
}

async function nextPiped(question: string): Promise<string> {
  process.stdout.write(question);
  const line = (await pipedLines()).shift();
  process.stdout.write("\n");
  if (line === undefined) throw new Error("the input ended before every question was answered");
  return line.trim();
}

export function ask(question: string, fallback = ""): Promise<string> {
  const text = `${question}${fallback ? ` [${fallback}]` : ""}: `;
  if (!process.stdin.isTTY) return nextPiped(text).then((a) => a || fallback);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((done) =>
    rl.question(text, (a) => {
      rl.close();
      done(a.trim() || fallback);
    }),
  );
}

/** A line that is not shown as it is typed. */
export function askUnseen(question: string): Promise<string> {
  if (!process.stdin.isTTY) return nextPiped(`${question}: `);
  return new Promise((done) => {
    const input = process.stdin;
    process.stdout.write(`${question}: `);
    let value = "";
    input.setRawMode(true);
    input.resume();
    const onData = (chunk: Buffer) => {
      for (const c of chunk.toString()) {
        if (c === "\n" || c === "\r" || c === "\u0004") {
          input.setRawMode(false);
          input.pause();
          input.off("data", onData);
          process.stdout.write("\n");
          return done(value);
        }
        if (c === "\u0003") process.exit(130);
        if (c === "\u007f") value = value.slice(0, -1);
        else value += c;
      }
    };
    input.on("data", onData);
  });
}
