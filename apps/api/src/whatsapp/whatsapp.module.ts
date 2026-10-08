import { Module } from '@nestjs/common';
import { AssistantModule } from '../assistant/assistant.module';
import { AllowlistService } from './allowlist.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

@Module({
  imports: [AssistantModule],
  controllers: [WhatsappController],
  providers: [WhatsappService, AllowlistService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
