import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: null, create: vi.fn(), update: vi.fn(), rows: vi.fn(), identity: vi.fn() }));
vi.mock("@/models", () => ({ createProviderConnection: mocks.create, updateProviderConnection: mocks.update, getProviderConnections: mocks.rows, deleteProviderConnection: vi.fn() }));
vi.mock("open-sse/services/webLogin.js", () => ({ getWebLoginStatus: () => mocks.session, startWebLogin: vi.fn(), cancelWebLogin: vi.fn(), listWebLoginProfiles: () => [] }));
vi.mock("open-sse/services/webIdentity.js", () => ({ fetchWebIdentity: mocks.identity }));
import { GET } from "../../src/app/api/providers/web-login/route.js";
const request = { nextUrl: new URL("http://localhost/api/providers/web-login?provider=grok-web") };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session = { status: "success", credential: "secret-cookie", browserVerified: true };
  mocks.identity.mockResolvedValue({ status: "valid", email: "test@example.test" });
  mocks.rows.mockResolvedValue([]);
  mocks.create.mockResolvedValue({ id: "saved" });
});
describe("web-login persistence", () => {
  it("saves a successful session once across concurrent polls", async () => {
    mocks.create.mockResolvedValueOnce({ id: "saved" }).mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: "PROVIDER_NAME_CONFLICT" }));
    const replies = await Promise.all([GET(request), GET(request), GET(request)]);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.identity).toHaveBeenCalledTimes(1);
    for (const reply of replies) expect(await reply.json()).toMatchObject({ status: "success", connectionId: "saved" });
    expect(mocks.session.credential).toBeUndefined();
    await GET(request);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it("updates an existing account once across concurrent polls", async () => {
    mocks.rows.mockResolvedValue([{ id: "old", email: "test@example.test", providerSpecificData: { authMethod: "web-login" } }]);
    mocks.update.mockResolvedValue({ id: "old" });
    await Promise.all([GET(request), GET(request)]);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("shares a save failure without retrying the failed session", async () => {
    mocks.create.mockRejectedValue(new Error("disk unavailable"));
    const replies = await Promise.all([GET(request), GET(request)]);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    for (const reply of replies) expect(await reply.json()).toMatchObject({ status: "error", error: "disk unavailable" });
    await GET(request);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    mocks.session = { status: "success", credential: "new-cookie", browserVerified: true };
    mocks.create.mockResolvedValue({ id: "retry" });
    expect(await (await GET(request)).json()).toMatchObject({ status: "success", connectionId: "retry" });
  });
});
