import { Module } from '@nestjs/common';
import { AssistantModule } from '../assistant/assistant.module';
import { EmpresasModule } from '../empresas/empresas.module';
import { AllowlistService } from './allowlist.service';
import { SessionManagerService } from './session-manager.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

@Module({
  imports: [AssistantModule, EmpresasModule],
  controllers: [WhatsappController],
  providers: [WhatsappService, AllowlistService, SessionManagerService],
  exports: [WhatsappService, SessionManagerService],
})
export class WhatsappModule {}
