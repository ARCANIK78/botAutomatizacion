import { Module } from '@nestjs/common';
import { AssistantService } from './assistant.service';
import { LlmService } from './llm.service';

@Module({
  providers: [LlmService, AssistantService],
  exports: [AssistantService],
})
export class AssistantModule {}
