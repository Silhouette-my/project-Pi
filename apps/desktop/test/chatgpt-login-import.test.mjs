import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { transferChatLogin } = await import("../electron/main/chatgpt-login-import.ts");
const login = { name: "__Secure-next-auth.session-token", value: "synthetic", domain: ".chatgpt.com", path: "/", secure: true, httpOnly: true, session: false, expirationDate: 2000000000, sameSite: "lax" };
function store(initial, failName) {
  let cookies = [...initial];
  return {
    get: async () => cookies,
    set: async (cookie) => {
      if (cookie.name === failName) throw new Error("Synthetic write failure");
      cookies = cookies.filter((item) => item.name !== cookie.name);
      cookies.push(cookie);
    },
    remove: async (_url, name) => { cookies = cookies.filter((cookie) => cookie.name !== name); },
    flushStore: async () => {},
  };
}
test("imports ChatGPT login without copying unrelated domains or changing the source", async () => {
  const source = store([login, { ...login, domain: ".example.com", name: "unrelated" }]);
  const target = store([]);
  await transferChatLogin(source, target);
  const result = await target.get({});
  assert.equal(result.length, 1);
  assert.equal(result[0].httpOnly, true);
  assert.equal(result[0].url, "https://chatgpt.com/");
  assert.equal((await source.get({})).length, 2);
});
test("cookie names are not treated as an authentication protocol", async () => {
  const target = store([]);
  await transferChatLogin(store([{ ...login, name: "provider-managed-session" }]), target);
  assert.equal((await target.get({}))[0].name, "provider-managed-session");
});
test("failed import restores overwritten destination preferences", async () => {
  const preference = { ...login, name: "preference", value: "original" };
  const target = store([preference], "fail");
  await assert.rejects(transferChatLogin(store([
    login, { ...preference, value: "imported" }, { ...login, name: "fail" },
  ]), target), /restored/);
  assert.deepEqual((await target.get({})).map(({ name, value }) => ({ name, value })), [
    { name: "preference", value: "original" },
  ]);
});
test("missing source login leaves destination unchanged", async () => {
  const target = store([]);
  await assert.rejects(transferChatLogin(store([]), target), /could not read any ChatGPT cookies/);
  assert.deepEqual(await target.get({}), []);
});
