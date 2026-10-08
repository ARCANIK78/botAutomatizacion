import { Body, Controller, Headers, Post } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post('notify')
  notify(
    @Body() body: { to?: string; message?: string; idempotencyKey?: string },
    @Headers('authorization') authorization?: string,
  ) {
    return this.webhooks.notify(body ?? {}, authorization);
  }
}
