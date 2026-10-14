import { Global, Module } from '@nestjs/common';
import { Backend1AuthService } from './backend1-auth.service';
import { SessionStorageService } from './session-storage.service';

@Global()
@Module({
  providers: [Backend1AuthService, SessionStorageService],
  exports: [Backend1AuthService, SessionStorageService],
})
export class Backend1AuthModule {}
