import { Module, Global } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Provider } from '@nestjs/common';

@Global()
@Module({
  providers: [
    {
      provide: 'PrismaClient',
      useFactory: () => {
        const client = new PrismaClient();
        // Fire-and-forget eager connect: Prisma lazy-connects on first query,
        // which adds ~200-800ms to the first request after every Render cold
        // start. Kicking $connect at boot (without blocking) moves that cost
        // off the user's first tap. Never fails boot.
        client.$connect().catch(() => undefined);
        return client;
      },
    },
  ],
  exports: ['PrismaClient'],
})
export class DatabaseModule {}
