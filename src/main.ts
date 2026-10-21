import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import compression from 'compression';
import { getJwtSecret } from './auth/jwt-secret.util';

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (logged, server kept alive):', reason);
});

function validateEnv() {
  getJwtSecret();
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required in production');
    }
    // Same-origin cloud deploys are covered by RENDER_EXTERNAL_URL
    // (allowlisted automatically below) — only demand an explicit list
    // when there is no platform-provided origin either.
    if (!process.env.CORS_ORIGIN && !process.env.RENDER_EXTERNAL_URL) {
      throw new Error('CORS_ORIGIN must be set in production');
    }
  }
}

async function bootstrap() {
  validateEnv();
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  // Gzip/deflate every eligible response (static JS/CSS + API JSON).
  // Without this Render serves the 523KB bundle RAW over a slow free-tier
  // link (~2.7s measured); gzipped it drops to ~170KB (<1s) and API JSON
  // shrinks 4-8x. Must be registered before ServeStaticModule routes so it
  // wraps the static-file responses too. threshold=1024 skips tiny bodies.
  app.use(compression({ threshold: 1024 }));

  const isProduction = process.env.NODE_ENV === 'production';
  const allowedOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Render injects RENDER_EXTERNAL_URL (https://<service>.onrender.com).
  // Same-origin cloud deploys stay working with zero extra config.
  if (process.env.RENDER_EXTERNAL_URL) {
    allowedOrigins.push(process.env.RENDER_EXTERNAL_URL);
  }

  app.enableCors({
    origin: allowedOrigins.length > 0
      ? allowedOrigins
      : isProduction
        ? false
        : true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });
  
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }));

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Yazh Isai API')
    .setDescription('Music Intelligence Core: catalog, streaming, lyrics, library, profiles')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const swaggerDoc = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, swaggerDoc);

  const port = process.env.PORT || 5000;
  await app.listen(port, '0.0.0.0');
  console.log(`🚀 Music Intelligence Core running on: http://localhost:${port}/api/v1`);
}
bootstrap();
