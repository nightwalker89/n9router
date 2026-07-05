import { subscribeCursorByokJob } from "@/lib/cursorByok/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { jobId } = await params;
  const encoder = new TextEncoder();
  let cleanup = null;

  const stream = new ReadableStream({
    start(controller) {
      const unsubscribe = subscribeCursorByokJob(jobId, (chunk) => {
        controller.enqueue(encoder.encode(chunk));
      });
      if (!unsubscribe) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "Cursor BYOK job not found" })}\n\n`));
        controller.close();
        return;
      }
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 15000);
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
