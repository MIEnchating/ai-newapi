import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma.service';

const passwordIterations = 310_000;
const passwordKeyLength = 32;
const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;

type CountRow = {
  count: bigint | number;
};

type AdminUserRow = {
  id: string;
  username: string;
  passwordHash: string;
  passwordSalt: string;
  passwordIterations: number;
};

type AdminSessionRow = {
  expiresAt: Date;
  userId: string;
  username: string;
};

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async status(token?: string) {
    const userCount = await this.userCount();

    if (userCount === 0) {
      return { setupRequired: true, authenticated: false };
    }

    const user = token ? await this.userForSession(token) : null;

    return {
      setupRequired: false,
      authenticated: Boolean(user),
      username: user?.username
    };
  }

  async setup(input: { username?: string; password?: string }) {
    const existing = await this.userCount();
    if (existing > 0) {
      throw new ConflictException('登录账号已设置');
    }

    const username = input.username?.trim() || 'admin';
    const password = input.password ?? '';
    const passwordError = validatePassword(password);
    if (passwordError) {
      throw new BadRequestException(passwordError);
    }

    const hashed = hashPassword(password);
    const id = createId();
    await this.prisma.$executeRaw`
      INSERT INTO AdminUser (id, username, passwordHash, passwordSalt, passwordIterations, createdAt, updatedAt)
      VALUES (${id}, ${username}, ${hashed.hash}, ${hashed.salt}, ${hashed.iterations}, NOW(3), NOW(3))
    `;
    const token = await this.createSession(id);

    return { authenticated: true, username, token };
  }

  async login(input: { username?: string; password?: string }) {
    const username = input.username?.trim() || 'admin';
    const [user] = await this.prisma.$queryRaw<AdminUserRow[]>`
      SELECT id, username, passwordHash, passwordSalt, passwordIterations
      FROM AdminUser
      WHERE username = ${username}
      LIMIT 1
    `;

    if (!user || !verifyPassword(input.password ?? '', user)) {
      throw new UnauthorizedException('账号或密码错误');
    }

    const token = await this.createSession(user.id);
    return { authenticated: true, username: user.username, token };
  }

  async logout(token?: string) {
    if (token) {
      await this.prisma.$executeRaw`DELETE FROM AdminSession WHERE tokenHash = ${hashToken(token)}`;
    }

    return { authenticated: false };
  }

  private async createSession(userId: string) {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.$executeRaw`
      INSERT INTO AdminSession (id, userId, tokenHash, expiresAt, createdAt)
      VALUES (${createId()}, ${userId}, ${hashToken(token)}, ${new Date(Date.now() + sessionTtlMs)}, NOW(3))
    `;

    return token;
  }

  private async userForSession(token: string) {
    await this.prisma.$executeRaw`DELETE FROM AdminSession WHERE expiresAt < ${new Date()}`;

    const [session] = await this.prisma.$queryRaw<AdminSessionRow[]>`
      SELECT s.expiresAt, s.userId, u.username
      FROM AdminSession s
      INNER JOIN AdminUser u ON u.id = s.userId
      WHERE s.tokenHash = ${hashToken(token)}
      LIMIT 1
    `;

    return session && session.expiresAt > new Date()
      ? { id: session.userId, username: session.username }
      : null;
  }

  private async userCount() {
    const [row] = await this.prisma.$queryRaw<CountRow[]>`SELECT COUNT(*) AS count FROM AdminUser`;
    return Number(row?.count ?? 0);
  }
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString('base64url');
  const hash = pbkdf2Sync(password, salt, passwordIterations, passwordKeyLength, 'sha256').toString('base64url');

  return { salt, hash, iterations: passwordIterations };
}

function verifyPassword(
  password: string,
  stored: { passwordSalt: string; passwordHash: string; passwordIterations: number }
) {
  const candidate = pbkdf2Sync(password, stored.passwordSalt, stored.passwordIterations, passwordKeyLength, 'sha256');
  const expected = Buffer.from(stored.passwordHash, 'base64url');

  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function validatePassword(password: string) {
  if (password.length < 8) {
    return '密码至少 8 位';
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return '密码需要同时包含字母和数字';
  }

  return null;
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('base64url');
}

function createId() {
  return `auth_${randomBytes(16).toString('base64url')}`;
}
