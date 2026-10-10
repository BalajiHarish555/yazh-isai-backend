import { Module, Global } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Provider } from '@nestjs/common';

@Global()
@Module({
  providers: [
    {
      provide: 'PrismaClient',
      useFactory: () => {
        return new PrismaClient();
      },
    },
  ],
  exports: ['PrismaClient'],
})
export class DatabaseModule {}
