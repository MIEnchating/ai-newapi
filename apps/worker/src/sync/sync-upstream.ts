import { percentChange, stableRateKey, type RateInfo, type UpstreamAdapter } from '@ai-relay/shared';
import { PrismaClient, RateDirection, UpstreamStatus, UpstreamType } from '@prisma/client';
import { decryptCredentialPayload } from '../credentials';
import { NewApiAdapter } from '../upstream-adapters/newapi-adapter';
import { Sub2ApiAdapter } from '../upstream-adapters/sub2api-adapter';

const prisma = new PrismaClient();

export async function syncUpstream(upstreamId: string) {
  const upstream = await prisma.upstream.findUnique({
    where: { id: upstreamId },
    include: { credential: true }
  });

  if (!upstream) {
    throw new Error(`upstream not found: ${upstreamId}`);
  }

  try {
    const adapter = createAdapter(upstream);
    const state = await adapter.getAccountState();
    const rates = await adapter.listRates();
    const previous = await loadPreviousRates(upstreamId, rates);
    const events = diffRates(previous, rates);

    await prisma.$transaction(async (tx) => {
      await tx.upstream.update({
        where: { id: upstreamId },
        data: {
          status: toPrismaStatus(state.status),
          balance: state.balance,
          balanceCurrency: state.balanceCurrency,
          concurrency: state.concurrency,
          lastError: state.lastError,
          lastSyncAt: new Date()
        }
      });

      if (rates.length > 0) {
        await tx.rateSnapshot.createMany({
          data: rates.map((rate) => ({
            upstreamId,
            provider: rate.provider,
            model: rate.model,
            groupName: rate.group,
            channelName: rate.channelName,
            inputPrice: rate.inputPrice,
            outputPrice: rate.outputPrice,
            modelRatio: rate.modelRatio,
            completionRatio: rate.completionRatio,
            currency: rate.currency,
            source: rate.source,
            rawHash: rate.rawHash,
            capturedAt: new Date(rate.capturedAt)
          }))
        });
      }

      if (events.length > 0) {
        await tx.rateChangeEvent.createMany({
          data: events.map((event) => ({
            upstreamId,
            provider: event.provider,
            model: event.model,
            groupName: event.group,
            field: event.field,
            direction: event.direction,
            oldValue: event.oldValue,
            newValue: event.newValue,
            changePercent: event.changePercent
          }))
        });
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown sync error';
    const challenge = /cloudflare|challenge|captcha|turnstile/i.test(message);

    await prisma.upstream.update({
      where: { id: upstreamId },
      data: {
        status: challenge ? UpstreamStatus.CHALLENGE_REQUIRED : UpstreamStatus.ERROR,
        lastError: message,
        lastSyncAt: new Date()
      }
    });

    throw error;
  }
}

function createAdapter(upstream: {
  type: UpstreamType;
  baseUrl: string;
  authMode: string;
  credential: { encryptedPayload: string } | null;
}): UpstreamAdapter {
  const credential = parseCredential(upstream.credential?.encryptedPayload);

  if (upstream.type === UpstreamType.SUB2API) {
    return new Sub2ApiAdapter({
      baseUrl: upstream.baseUrl,
      authMode: upstream.authMode.toLowerCase(),
      credential
    });
  }

  if (upstream.type === UpstreamType.NEWAPI) {
    return new NewApiAdapter({
      baseUrl: upstream.baseUrl,
      authMode: upstream.authMode.toLowerCase(),
      credential
    });
  }

  throw new Error(`unsupported upstream type: ${upstream.type}`);
}

function parseCredential(payload?: string): Record<string, string> {
  return decryptCredentialPayload(payload);
}

function toPrismaStatus(status: string): UpstreamStatus {
  return status.toUpperCase() as UpstreamStatus;
}

async function loadPreviousRates(upstreamId: string, currentRates: RateInfo[]) {
  const previous = new Map<string, RateInfo>();

  for (const rate of currentRates) {
    const snapshot = await prisma.rateSnapshot.findFirst({
      where: {
        upstreamId,
        provider: rate.provider,
        model: rate.model,
        groupName: rate.group
      },
      orderBy: { capturedAt: 'desc' }
    });

    if (!snapshot) {
      continue;
    }

    previous.set(stableRateKey(rate), {
      provider: snapshot.provider,
      model: snapshot.model,
      group: snapshot.groupName ?? undefined,
      channelName: snapshot.channelName ?? undefined,
      inputPrice: snapshot.inputPrice ? Number(snapshot.inputPrice) : undefined,
      outputPrice: snapshot.outputPrice ? Number(snapshot.outputPrice) : undefined,
      modelRatio: snapshot.modelRatio ? Number(snapshot.modelRatio) : undefined,
      completionRatio: snapshot.completionRatio ? Number(snapshot.completionRatio) : undefined,
      currency: snapshot.currency ?? undefined,
      source: snapshot.source,
      capturedAt: snapshot.capturedAt.toISOString(),
      rawHash: snapshot.rawHash ?? undefined
    });
  }

  return { previous };
}

function diffRates(
  loaded: { previous: Map<string, RateInfo> },
  currentRates: RateInfo[]
): Array<{
  provider: string;
  model: string;
  group?: string;
  field: string;
  direction: RateDirection;
  oldValue?: number;
  newValue?: number;
  changePercent?: number;
}> {
  const events = [];

  for (const current of currentRates) {
    const previous = loaded.previous.get(stableRateKey(current));

    if (!previous) {
      events.push({
        provider: current.provider,
        model: current.model,
        group: current.group,
        field: 'model_ratio',
        direction: RateDirection.NEW,
        newValue: current.modelRatio
      });
      continue;
    }

    for (const field of ['inputPrice', 'outputPrice', 'modelRatio', 'completionRatio'] as const) {
      const oldValue = previous[field];
      const newValue = current[field];

      if (oldValue === undefined || newValue === undefined || oldValue === newValue) {
        continue;
      }

      const changed = percentChange(oldValue, newValue);

      events.push({
        provider: current.provider,
        model: current.model,
        group: current.group,
        field: toDatabaseField(field),
        direction: newValue > oldValue ? RateDirection.UP : RateDirection.DOWN,
        oldValue,
        newValue,
        changePercent: changed
      });
    }
  }

  return events;
}

function toDatabaseField(field: 'inputPrice' | 'outputPrice' | 'modelRatio' | 'completionRatio') {
  return {
    inputPrice: 'input_price',
    outputPrice: 'output_price',
    modelRatio: 'model_ratio',
    completionRatio: 'completion_ratio'
  }[field];
}
