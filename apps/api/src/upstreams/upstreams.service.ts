import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthMode, UpstreamType } from '@prisma/client';
import { encryptCredentialPayload } from '../vault/credential-vault';
import { PrismaService } from '../prisma.service';
import { SyncQueueService } from './sync-queue.service';

const upstreamTypes = new Set(Object.values(UpstreamType));
const authModes = new Set(Object.values(AuthMode));

@Injectable()
export class UpstreamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly syncQueue: SyncQueueService
  ) {}

  list() {
    return this.prisma.upstream.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: {
            rateSnapshots: true,
            rateChangeEvents: true
          }
        }
      }
    });
  }

  async create(input: {
    name: string;
    type: string;
    baseUrl: string;
    authMode: string;
    credential?: Record<string, string>;
  }) {
    const type = input.type.toUpperCase() as UpstreamType;
    const authMode = input.authMode.toUpperCase() as AuthMode;

    if (!input.name || !input.baseUrl) {
      throw new BadRequestException('name and baseUrl are required');
    }

    if (!upstreamTypes.has(type) || !authModes.has(authMode)) {
      throw new BadRequestException('unsupported upstream type or auth mode');
    }

    return this.prisma.upstream.create({
      data: {
        name: input.name,
        type,
        baseUrl: input.baseUrl,
        authMode,
        credential: input.credential
          ? {
              create: {
                encryptedPayload: encryptCredentialPayload(input.credential)
              }
            }
          : undefined
      },
      select: {
        id: true,
        name: true,
        type: true,
        baseUrl: true,
        authMode: true,
        status: true,
        createdAt: true
      }
    });
  }

  async sync(id: string) {
    const upstream = await this.prisma.upstream.findUnique({ where: { id } });

    if (!upstream) {
      throw new BadRequestException('upstream not found');
    }

    const job = await this.syncQueue.enqueue(id);

    return {
      queued: true,
      jobId: job.id,
      upstreamId: id
    };
  }

  rates(id: string) {
    return this.prisma.rateSnapshot.findMany({
      where: { upstreamId: id },
      orderBy: { capturedAt: 'desc' },
      take: 200
    });
  }
}
