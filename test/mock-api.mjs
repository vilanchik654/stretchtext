/**
 * A local stand-in for gen.pollinations.ai, used by the end-to-end suite.
 *
 * It speaks the same wire protocol the extension uses in production: an
 * OpenAI-compatible chat completion, streamed as SSE when `stream: true`, and
 * a JSON body otherwise. It rejects requests without a bearer key so the
 * suite also proves that the reader's key is attached by the service worker.
 */
import http from 'node:http';

const KERNEL =
  'Ted Nelson proposed {{stretchtext|1}} in 1967: text that grows where a reader wants more and shrinks back where they do not. It failed {{for practical reasons|2}}.';

const DETAILS = {
  stretchtext: ', a form of hypertext where any phrase can unfold into more detail,',
  'for practical reasons': ', because every level of detail had to be written and maintained by hand,',
};
const DEFAULT_DETAIL = ', because every level of detail had to be written and maintained by hand,';

export async function startMockApi() {
  const requests = [];

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"not found"}}');
      return;
    }

    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* fall through to the 400 below */
      }
      const auth = req.headers.authorization || '';
      requests.push({
        model: body.model,
        stream: Boolean(body.stream),
        auth,
        system: (body.messages && body.messages[0] && body.messages[0].content) || '',
        user: (body.messages && body.messages[1] && body.messages[1].content) || '',
      });

      if (!/^Bearer sk_/.test(auth)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            success: false,
            error: { message: 'A valid API key is required.', code: 'UNAUTHORIZED' },
            status: 401,
          })
        );
        return;
      }

      const system = String((body.messages && body.messages[0] && body.messages[0].content) || '');
      const user = String((body.messages && body.messages[1] && body.messages[1].content) || '');
      const isDetail = /expand one phrase/i.test(system);
      const clicked = /The reader clicked: "(.*)"/.exec(user);
      const answer = isDetail ? DETAILS[clicked && clicked[1]] || DEFAULT_DETAIL : KERNEL;

      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
          })
        );
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const pieces = answer.match(/\S+\s*/g) || [answer];
      for (const piece of pieces) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
        await new Promise((r) => setTimeout(r, 12));
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}
