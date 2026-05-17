import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient(
  process.env.DATABASE_URL
    ? {
        datasources: {
          db: {
            url: pooledDatabaseUrl(process.env.DATABASE_URL)
          }
        }
      }
    : undefined
);

function pooledDatabaseUrl(value: string) {
  try {
    const url = new URL(value);

    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', process.env.DATABASE_CONNECTION_LIMIT ?? '3');
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', process.env.DATABASE_POOL_TIMEOUT ?? '20');
    }

    return url.toString();
  } catch {
    return value;
  }
}
