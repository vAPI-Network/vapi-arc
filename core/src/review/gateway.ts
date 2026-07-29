import {
  BatchFacilitatorClient,
  GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS,
} from "@circle-fin/x402-batching/server";
import {
  getAddress,
  isAddress,
  isHex,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import type { ReviewServiceConfig } from "./config.js";
import {
  ReviewDatabase,
  type GatewayPaymentReservationInput,
  type RecoverableGatewayReservation,
} from "./database.js";
import type {
  ReviewOrder,
  ReviewPayment,
  ValidatedReviewJob,
} from "./types.js";

type GatewayPaymentPayload = Parameters<BatchFacilitatorClient["verify"]>[0];
type GatewayPaymentRequirements = Parameters<
  BatchFacilitatorClient["verify"]
>[1];
type GatewayVerifyResult = Awaited<
  ReturnType<BatchFacilitatorClient["verify"]>
>;
type GatewaySettleResult = Awaited<
  ReturnType<BatchFacilitatorClient["settle"]>
>;

interface GatewaySettlementClient {
  verify(
    payload: GatewayPaymentPayload,
    requirements: GatewayPaymentRequirements,
  ): Promise<GatewayVerifyResult>;
  settle(
    payload: GatewayPaymentPayload,
    requirements: GatewayPaymentRequirements,
  ): Promise<GatewaySettleResult>;
}

export interface GatewayRecoveryResult {
  orders: ReviewOrder[];
  discarded: Array<{ token: string; reason: string }>;
  failures: Array<{ token: string; error: string }>;
}

export class PermanentGatewayRecoveryError extends Error {
  readonly permanent = true;
}

export interface GatewayRecoveryReviewIntent {
  request: {
    requestId: string;
    jobId: string;
    deliverable: {
      contentType: "text/plain";
      content: string;
    };
  };
  validatedJob: ValidatedReviewJob;
}

export type GatewayRecoveryPreflight = (input: {
  reservation: RecoverableGatewayReservation;
  intent: GatewayRecoveryReviewIntent;
}) => Promise<void>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(
  value: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new Error(`${label}.${field} must be a non-empty string`);
  }
  return candidate;
}

function sameAddress(left: string, right: Address): boolean {
  return isAddress(left) && getAddress(left) === right;
}

function isUintString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

export function gatewayAuthorizationKey(payer: Address, nonce: Hex): Hex {
  return keccak256(toBytes(`${payer.toLowerCase()}:${nonce.toLowerCase()}`));
}

/**
 * Decode and bind the signed x402 authorization to the exact immutable quote
 * before the Circle middleware can make an external settlement call.
 */
export function parseGatewayPaymentReservation(
  paymentSignature: string | undefined,
  config: ReviewServiceConfig,
): GatewayPaymentReservationInput | undefined {
  if (!paymentSignature) return undefined;
  if (!config.sellerAddress) {
    throw new Error("x402 seller address is not configured");
  }
  if (paymentSignature.length > 32_768) {
    throw new Error("Payment-Signature header is too large");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(paymentSignature, "base64").toString("utf8"),
    );
  } catch {
    throw new Error("Payment-Signature is not valid base64 JSON");
  }
  const paymentPayload = record(decoded, "payment payload");
  if (paymentPayload.x402Version !== 2) {
    throw new Error("Payment-Signature must use x402 version 2");
  }

  const requirements = record(
    paymentPayload.accepted,
    "payment payload.accepted",
  );
  const extra = record(requirements.extra, "payment payload.accepted.extra");
  const payload = record(paymentPayload.payload, "payment payload.payload");
  const authorization = record(
    payload.authorization,
    "payment payload.payload.authorization",
  );

  const network = stringField(requirements, "network", "accepted");
  const scheme = stringField(requirements, "scheme", "accepted");
  const asset = stringField(requirements, "asset", "accepted");
  const amount = stringField(requirements, "amount", "accepted");
  const payTo = stringField(requirements, "payTo", "accepted");
  const name = stringField(extra, "name", "accepted.extra");
  const version = stringField(extra, "version", "accepted.extra");
  const verifyingContract = stringField(
    extra,
    "verifyingContract",
    "accepted.extra",
  );
  if (
    scheme !== "exact" ||
    name !== "GatewayWalletBatched" ||
    version !== "1" ||
    network !== config.gatewayNetwork ||
    amount !== config.reviewPrice ||
    !sameAddress(payTo, config.sellerAddress) ||
    !sameAddress(asset, config.usdcTokenAddress) ||
    !isAddress(verifyingContract) ||
    requirements.maxTimeoutSeconds !== GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS
  ) {
    throw new Error(
      "Payment-Signature requirements do not match this review quote",
    );
  }

  const payer = stringField(authorization, "from", "authorization");
  const recipient = stringField(authorization, "to", "authorization");
  const value = stringField(authorization, "value", "authorization");
  const validAfter = authorization.validAfter;
  const validBefore = authorization.validBefore;
  const nonce = stringField(authorization, "nonce", "authorization");
  const signature = stringField(payload, "signature", "payment payload");
  if (
    !isAddress(payer) ||
    !sameAddress(recipient, config.sellerAddress) ||
    value !== config.reviewPrice ||
    !isUintString(validAfter) ||
    !isUintString(validBefore) ||
    BigInt(validBefore) <= BigInt(validAfter) ||
    !isHex(nonce) ||
    nonce.length !== 66 ||
    !isHex(signature) ||
    signature.length !== 132
  ) {
    throw new Error(
      "Payment-Signature authorization does not match this review quote",
    );
  }

  return {
    signatureHash: keccak256(toBytes(paymentSignature)),
    authorizationKey: gatewayAuthorizationKey(getAddress(payer), nonce as Hex),
    paymentPayload,
    paymentRequirements: requirements,
    payer: getAddress(payer),
    nonce: nonce as Hex,
  };
}

function nonceWasUsed(reason: string | undefined): boolean {
  if (!reason) return false;
  const normalized = reason.toLowerCase().replaceAll(/[\s-]+/g, "_");
  return normalized.includes("nonce_already_used");
}

function parseStoredGatewayIntent(reservation: RecoverableGatewayReservation): {
  payload: GatewayPaymentPayload;
  requirements: GatewayPaymentRequirements;
  payer: Address;
  nonce: Hex;
} {
  const payload = record(
    JSON.parse(reservation.paymentPayloadJson) as unknown,
    "stored payment payload",
  ) as unknown as GatewayPaymentPayload;
  const requirements = record(
    JSON.parse(reservation.paymentRequirementsJson) as unknown,
    "stored payment requirements",
  ) as unknown as GatewayPaymentRequirements;
  if (
    !isAddress(reservation.payer) ||
    !isHex(reservation.nonce) ||
    reservation.nonce.length !== 66
  ) {
    throw new Error("stored Gateway payer or nonce is invalid");
  }
  return {
    payload,
    requirements,
    payer: getAddress(reservation.payer),
    nonce: reservation.nonce as Hex,
  };
}

function assertStoredGatewayQuote(
  config: ReviewServiceConfig,
  reservation: RecoverableGatewayReservation,
  requirementsInput: GatewayPaymentRequirements,
): void {
  const requirements = requirementsInput as unknown as Record<string, unknown>;
  const extra = record(requirements.extra, "stored payment requirements.extra");
  const scheme = stringField(requirements, "scheme", "requirements");
  const network = stringField(requirements, "network", "requirements");
  const asset = stringField(requirements, "asset", "requirements");
  const amount = stringField(requirements, "amount", "requirements");
  const payTo = stringField(requirements, "payTo", "requirements");
  const name = stringField(extra, "name", "requirements.extra");
  const version = stringField(extra, "version", "requirements.extra");
  const verifyingContract = stringField(
    extra,
    "verifyingContract",
    "requirements.extra",
  );
  if (
    !config.sellerAddress ||
    scheme !== "exact" ||
    network !== config.gatewayNetwork ||
    network !== reservation.network ||
    amount !== config.reviewPrice ||
    amount !== reservation.reviewPrice ||
    reservation.reward !== config.reviewerReward ||
    !sameAddress(asset, config.usdcTokenAddress) ||
    !sameAddress(payTo, config.sellerAddress) ||
    name !== "GatewayWalletBatched" ||
    version !== "1" ||
    !isAddress(verifyingContract) ||
    requirements.maxTimeoutSeconds !== GATEWAY_AUTH_VALIDITY_WINDOW_SECONDS
  ) {
    throw new PermanentGatewayRecoveryError(
      "stored Gateway authorization no longer matches the configured review quote",
    );
  }
}

function parseStoredReviewIntent(
  reservation: RecoverableGatewayReservation,
): GatewayRecoveryReviewIntent {
  try {
    const root = record(
      JSON.parse(reservation.intentJson) as unknown,
      "stored review intent",
    );
    const request = record(root.request, "stored review intent.request");
    const deliverable = record(
      request.deliverable,
      "stored review intent.request.deliverable",
    );
    const validatedJob = record(
      root.validatedJob,
      "stored review intent.validatedJob",
    );
    const requestId = stringField(request, "requestId", "request");
    const jobId = stringField(request, "jobId", "request");
    const contentType = stringField(
      deliverable,
      "contentType",
      "request.deliverable",
    );
    const content = deliverable.content;
    const validatedJobId = stringField(validatedJob, "jobId", "validatedJob");
    const client = stringField(validatedJob, "client", "validatedJob");
    const provider = stringField(validatedJob, "provider", "validatedJob");
    const evaluator = stringField(validatedJob, "evaluator", "validatedJob");
    const description = validatedJob.description;
    const budget = stringField(validatedJob, "budget", "validatedJob");
    const expiredAt = stringField(validatedJob, "expiredAt", "validatedJob");
    const deliverableHash = stringField(
      validatedJob,
      "deliverableHash",
      "validatedJob",
    );
    const escalationReasonHash = stringField(
      validatedJob,
      "escalationReasonHash",
      "validatedJob",
    );
    if (
      requestId !== reservation.requestId ||
      jobId !== reservation.jobId ||
      validatedJobId !== reservation.jobId ||
      contentType !== "text/plain" ||
      typeof content !== "string" ||
      typeof description !== "string" ||
      !isAddress(client) ||
      !isAddress(provider) ||
      !isAddress(evaluator) ||
      !isUintString(budget) ||
      !isUintString(expiredAt) ||
      !isHex(deliverableHash) ||
      deliverableHash.length !== 66 ||
      !isHex(escalationReasonHash) ||
      escalationReasonHash.length !== 66
    ) {
      throw new Error("stored review recovery intent is invalid");
    }
    return {
      request: {
        requestId,
        jobId,
        deliverable: { contentType: "text/plain", content },
      },
      validatedJob: {
        ...(validatedJob as unknown as ValidatedReviewJob),
        jobId: validatedJobId,
        client: getAddress(client),
        provider: getAddress(provider),
        evaluator: getAddress(evaluator),
        description,
        budget,
        expiredAt,
        deliverableHash: deliverableHash as Hex,
        escalationReasonHash: escalationReasonHash as Hex,
      },
    };
  } catch (error) {
    throw new PermanentGatewayRecoveryError(
      error instanceof Error
        ? error.message
        : "stored review recovery intent is invalid",
    );
  }
}

export class GatewayReservationReconciler {
  private running = false;

  constructor(
    private readonly config: ReviewServiceConfig,
    private readonly database: ReviewDatabase,
    private readonly client: GatewaySettlementClient = new BatchFacilitatorClient(
      { url: config.gatewayUrl },
    ),
    private readonly beforeSettle?: GatewayRecoveryPreflight,
  ) {}

  async reconcile(): Promise<GatewayRecoveryResult> {
    if (this.running) {
      return { orders: [], discarded: [], failures: [] };
    }
    this.running = true;
    const orders = new Map<string, ReviewOrder>();
    const discarded: GatewayRecoveryResult["discarded"] = [];
    const failures: GatewayRecoveryResult["failures"] = [];
    try {
      for (const token of this.database.discardExpiredUnattemptedReviewReservations()) {
        discarded.push({
          token,
          reason:
            "signed authorization expired locally before settlement began",
        });
      }
      const reservations = this.database.listRecoverableGatewayReservations();
      for (const reservation of reservations) {
        try {
          const existing = this.database.findOrderByRequestOrJob(
            reservation.requestId,
            reservation.jobId,
          );
          if (existing) {
            orders.set(existing.id, existing);
            continue;
          }
          const stored = parseStoredGatewayIntent(reservation);
          if (
            !reservation.reviewPrice ||
            !/^\d+$/.test(reservation.reviewPrice) ||
            !reservation.reward ||
            !/^\d+$/.test(reservation.reward) ||
            !reservation.network
          ) {
            throw new Error(
              "stored Gateway reservation is missing its immutable quote",
            );
          }
          const verification = await this.client.verify(
            stored.payload,
            stored.requirements,
          );
          let payment: ReviewPayment | undefined;
          if (!verification.isValid) {
            if (nonceWasUsed(verification.invalidReason)) {
              throw new Error(
                "Gateway reports nonce_already_used without the original transfer UUID; manual payment reconciliation is required",
              );
            }
            throw new Error(
              `Gateway verification cannot prove the earlier settlement attempt was not accepted: ${
                verification.invalidReason ??
                "Gateway rejected the stored authorization"
              }`,
            );
          } else {
            if (
              verification.payer &&
              (!isAddress(verification.payer) ||
                getAddress(verification.payer) !== stored.payer)
            ) {
              throw new PermanentGatewayRecoveryError(
                "Gateway verification payer does not match stored authorization",
              );
            }
            assertStoredGatewayQuote(
              this.config,
              reservation,
              stored.requirements,
            );
            if (!this.beforeSettle) {
              throw new Error(
                "Gateway recovery fulfillment preflight is not configured",
              );
            }
            await this.beforeSettle({
              reservation,
              intent: parseStoredReviewIntent(reservation),
            });
            const settlement = await this.client.settle(
              stored.payload,
              stored.requirements,
            );
            if (settlement.success) {
              if (
                !settlement.transaction?.trim() ||
                settlement.network !== reservation.network ||
                (settlement.payer &&
                  (!isAddress(settlement.payer) ||
                    getAddress(settlement.payer) !== stored.payer))
              ) {
                throw new Error(
                  "Gateway settlement provenance does not match the reservation",
                );
              }
              payment = {
                verified: true,
                payer: stored.payer,
                amount: reservation.reviewPrice,
                network: reservation.network,
                transaction: settlement.transaction,
              };
            } else if (nonceWasUsed(settlement.errorReason)) {
              throw new Error(
                "Gateway reports nonce_already_used without the original transfer UUID; manual payment reconciliation is required",
              );
            } else {
              throw new Error(
                settlement.errorReason ??
                  "Gateway settlement returned an indeterminate failure",
              );
            }
          }

          this.database.recordReviewReservationSettlement(
            reservation.token,
            payment,
          );
          const promoted = this.database.promoteReviewReservation(
            reservation.token,
          );
          if (!promoted) {
            throw new Error(
              "recovered Gateway settlement could not be promoted",
            );
          }
          orders.set(promoted.order.id, promoted.order);
        } catch (error) {
          const existing = this.database.findOrderByRequestOrJob(
            reservation.requestId,
            reservation.jobId,
          );
          if (existing) {
            orders.set(existing.id, existing);
            continue;
          }
          const message =
            error instanceof Error ? error.message : String(error);
          this.database.deferGatewayReservationRecovery(
            reservation.token,
            message,
            message.includes("manual payment reconciliation")
              ? 24 * 60 * 60_000
              : undefined,
          );
          failures.push({ token: reservation.token, error: message });
        }
      }
    } finally {
      this.running = false;
    }
    return { orders: [...orders.values()], discarded, failures };
  }
}
