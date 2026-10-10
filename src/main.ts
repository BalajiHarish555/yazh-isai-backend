import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

// Never let a stray unhandled rejection kill the server in production.
// (A ytdl-core rejection once crashed the process on a routine play request.)
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (logged, server kept alive):', reason);
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });
  
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }));

  const port = process.env.PORT || 5000;
  await app.listen(port, '0.0.0.0');
  console.log(`🚀 Music Intelligence Core running on: http://localhost:${port}/api/v1`);
}
bootstrap();
