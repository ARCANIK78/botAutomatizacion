import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadEnvFile } from './common/load-env';
import { env } from './config';

loadEnvFile();

const API_PREFIXES = ['/api', '/webhooks'];

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors();
  app.set('trust proxy', 1);

  const webDist = join(__dirname, '..', '..', 'web', 'dist');
  const hasWeb = existsSync(join(webDist, 'index.html'));

  if (hasWeb) {
    app.useStaticAssets(webDist, { index: false });
    app.use(
      (
        req: { method: string; path: string },
        res: unknown,
        next: () => void,
      ) => {
        if (req.method !== 'GET') return next();
        if (
          req.path === '/health' ||
          API_PREFIXES.some((prefix) => req.path.startsWith(prefix))
        ) {
          return next();
        }
        if (req.path.includes('.')) return next();
        (res as { sendFile: (path: string) => void }).sendFile(
          join(webDist, 'index.html'),
        );
      },
    );
  }

  await app.listen(env.port());

  console.log(
    `API en http://localhost:${env.port()} (web: ${hasWeb ? 'servida' : 'modo dev'})`,
  );
}
void bootstrap();
