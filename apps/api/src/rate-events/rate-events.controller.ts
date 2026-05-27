import { Controller, Get, Inject, Query } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Controller('rate-events')
export class RateEventsController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  list(@Query('upstreamId') upstreamId?: string) {
    return this.prisma.rateChangeEvent.findMany({
      where: upstreamId ? { upstreamId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        upstream: {
          select: {
            id: true,
            name: true,
            type: true,
            status: true
          }
        }
      }
    });
  }
}
