import { afterEach, expect, it } from "vitest";
import { AgentSidecar } from "./agent-sidecar.js";

const sidecars: AgentSidecar[] = [];
afterEach(async () => { await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.dispose())); });

it("routes browser conversation RPC and stream notifications over the real stdio boundary", async () => {
  const source = `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    let caller;
    rl.on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'probe') {
        caller = request.id;
        console.log(JSON.stringify({id:'open',method:'host.proxy',params:{method:'chatgpt.conversation.open',params:{requestId:'stream',body:{action:'next'}}}}));
      } else if (request.method === 'host.notification') {
        console.log(JSON.stringify({id:'cancel',method:'host.proxy',params:{method:'chatgpt.conversation.cancel',params:{requestId:'stream'}}}));
      } else if (request.id === 'cancel') console.log(JSON.stringify({id:caller,result:request.result}));
    });`;
  const sidecar = new AgentSidecar({ launch: { command: process.execPath, args: ["-e", source] }, onStderr: () => {} });
  sidecars.push(sidecar);
  const opened: unknown[] = [];
  sidecar.setChatGptConversationTransport({
    open: async (params) => { opened.push(params); sidecar.notifyHost("chatgpt.conversation.chunk", { requestId: "stream", chunk: "data: hello\n\n" }); return { ok: true }; },
    cancel: async (params) => ({ cancelled: params.requestId }),
  });
  expect(await sidecar.call("probe")).toEqual({ cancelled: "stream" });
  expect(opened).toEqual([{ requestId: "stream", body: { action: "next" } }]);
});
