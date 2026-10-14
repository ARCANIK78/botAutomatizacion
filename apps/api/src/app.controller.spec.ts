import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WhatsappService } from './whatsapp/whatsapp.service';
import { Backend1AuthService } from './common/backend1-auth.service';

describe('AppController', () => {
  let appController: AppController;

  const whatsappStub = {
    getStatus: () => ({
      state: 'connected',
      qr: null,
      user: '59170000000',
      at: 0,
    }),
  };

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        { provide: WhatsappService, useValue: whatsappStub },
        { provide: Backend1AuthService, useValue: { diagnose: jest.fn() } },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('health', () => {
    it('devuelve status ok con el estado de WhatsApp', () => {
      const result = appController.health();
      expect(result.status).toBe('ok');
      expect(result.whatsapp.state).toBe('connected');
      expect(result.whatsapp.user).toBe('59170000000');
    });
  });
});
