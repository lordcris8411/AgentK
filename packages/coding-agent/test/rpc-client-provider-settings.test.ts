import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type PrivateClient = {
	send: (command: Record<string, unknown>) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

function mockedClient(data: unknown = undefined) {
	const client = new RpcClient();
	const internal = client as unknown as PrivateClient;
	const send = vi.fn(async (_command: Record<string, unknown>) => ({
		type: "response",
		command: "test",
		success: true,
		data,
	}));
	internal.send = send;
	internal.getData = <T>(response: unknown) => (response as { data: T }).data;
	return { client, send };
}

describe("RpcClient provider settings", () => {
	it("reads the provider catalog", async () => {
		const providers = [
			{ id: "ollama", name: "Ollama", source: "custom", configured: true, authMethods: [], models: [] },
		];
		const { client, send } = mockedClient({ providers });
		expect(await client.getProviderCatalog()).toEqual(providers);
		expect(send).toHaveBeenCalledWith({ type: "get_provider_catalog" });
	});

	it("sends login, cancellation, reload and logout commands", async () => {
		const { client, send } = mockedClient();
		await client.loginProvider("openai", "api_key", "secret");
		await client.cancelLogin();
		await client.reloadModels();
		await client.logoutProvider("openai");
		expect(send.mock.calls.map(([command]) => command)).toEqual([
			{ type: "login_provider", providerId: "openai", authType: "api_key", value: "secret" },
			{ type: "cancel_login" },
			{ type: "reload_models" },
			{ type: "logout_provider", providerId: "openai" },
		]);
	});
});
