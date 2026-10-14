import { Global, Module } from '@nestjs/common';
import { Backend1AuthService } from './backend1-auth.service';

@Global()
@Module({
  providers: [Backend1AuthService],
  exports: [Backend1AuthService],
})
export class Backend1AuthModule {}
