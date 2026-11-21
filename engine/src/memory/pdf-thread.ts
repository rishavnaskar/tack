/**
 * A PDF read in a worker thread, with a deadline and a heap of its own.
 *
 * The reader has budgets of its own (pdf.ts), and they are what normally ends
 * a hostile file. This is the second line: whatever a file finds that the
 * budgets miss, the process that serves the screen and every agent keeps
 * answering, and a file that runs out of time or memory counts as unreadable.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { extractPdfText, type PdfExtraction } from './pdf.ts';

const PDF_THREAD_MS = 20_000;
const HEAP_MB = 384;

if (!isMainThread && (workerData as { fanfoldPdf?: boolean } | null)?.fanfoldPdf) {
  parentPort!.once('message', (bytes: Uint8Array) => {
    parentPort!.postMessage(extractPdfText(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
  });
}

const unread = (why: string): PdfExtraction => ({ text: '', pages: 0, confidence: 0, warnings: [why] });

export function extractPdfTextOffThread(bytes: Buffer, timeoutMs = PDF_THREAD_MS): Promise<PdfExtraction> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL(import.meta.url), { workerData: { fanfoldPdf: true }, resourceLimits: { maxOldGenerationSizeMb: HEAP_MB } });
    } catch (err) {
      resolve(unread(`the PDF reader could not start: ${(err as Error).message}`));
      return;
    }
    let done = false;
    const finish = (result: PdfExtraction): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish(unread(`reading stopped: it took longer than ${timeoutMs / 1000} s`)), timeoutMs);
    worker.once('message', (result: PdfExtraction) => finish(result));
    worker.once('error', (err) => finish(unread(`reading stopped: ${(err as Error).message}`)));
    worker.once('exit', (code) => finish(unread(`the PDF reader stopped (exit ${code})`)));
    worker.postMessage(new Uint8Array(bytes));
  });
}
