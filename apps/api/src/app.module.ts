import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { Backend1AuthModule } from './common/backend1-auth.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { EmpresasModule } from './empresas/empresas.module';

@Module({
  imports: [Backend1AuthModule, WhatsappModule, WebhooksModule, EmpresasModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
