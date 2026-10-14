import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { EmpresasModule } from './empresas/empresas.module';

@Module({
  imports: [WhatsappModule, WebhooksModule, EmpresasModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
