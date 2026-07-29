import assert from "node:assert/strict";
import {
  createSign,
  generateKeyPairSync,
} from "node:crypto";
import { describe, it } from "node:test";
import {
  CircleWebhookInvalidKeyError,
  LiveCircleWebhookVerifier,
} from "./circle-webhook.js";

describe("Circle webhook verification", () => {
  it("imports Circle's base64 SPKI key, verifies the raw body, and caches by key id", async () => {
    const keyId = "09379bc1-4871-45ad-8b8b-8027795df70d";
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const body = Buffer.from('{"notificationId":"test"}');
    const signer = createSign("SHA256");
    signer.update(body);
    signer.end();
    const signature = signer.sign(privateKey).toString("base64");
    let fetches = 0;
    const fetcher: typeof fetch = async () => {
      fetches += 1;
      return new Response(
        JSON.stringify({
          data: {
            id: keyId,
            algorithm: "ECDSA_SHA_256",
            publicKey: publicKey
              .export({ format: "der", type: "spki" })
              .toString("base64"),
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const verifier = new LiveCircleWebhookVerifier("test-api-key", fetcher);

    assert.equal(await verifier.verify({ keyId, signature, body }), true);
    assert.equal(await verifier.verify({ keyId, signature, body }), true);
    assert.equal(
      await verifier.verify({
        keyId,
        signature,
        body: Buffer.from('{"notificationId":"tampered"}'),
      }),
      false,
    );
    assert.equal(fetches, 1);
  });

  it("coalesces concurrent key lookups and negatively caches invalid ids", async () => {
    const keyId = "19379bc1-4871-45ad-8b8b-8027795df70d";
    let fetches = 0;
    const fetcher: typeof fetch = async () => {
      fetches += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return new Response("not found", { status: 404 });
    };
    const verifier = new LiveCircleWebhookVerifier("test-api-key", fetcher);
    const input = {
      keyId,
      signature: "",
      body: Buffer.from("{}"),
    };

    const concurrent = await Promise.allSettled([
      verifier.verify(input),
      verifier.verify(input),
    ]);
    assert.equal(fetches, 1);
    for (const result of concurrent) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") {
        assert.ok(result.reason instanceof CircleWebhookInvalidKeyError);
      }
    }
    await assert.rejects(
      verifier.verify(input),
      CircleWebhookInvalidKeyError,
    );
    assert.equal(fetches, 1);
  });
});
