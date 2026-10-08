import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [WhatsappModule, WebhooksModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
