import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WhatsappService } from './whatsapp/whatsapp.service';
import { Backend1AuthService } from './common/backend1-auth.service';
import { SessionStorageService } from './common/session-storage.service';

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

  const sessionStorageStub = {
    check: jest.fn().mockResolvedValue({
      persistente: false,
      path: './data/auth',
      detalle: 'WHATSAPP_SESSION_PATH no configurada',
    }),
    logAlArrancar: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        { provide: WhatsappService, useValue: whatsappStub },
        { provide: Backend1AuthService, useValue: { diagnose: jest.fn() } },
        { provide: SessionStorageService, useValue: sessionStorageStub },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('health', () => {
    it('devuelve status ok con el estado de WhatsApp', async () => {
      const result = await appController.health();
      expect(result.status).toBe('ok');
      expect(result.whatsapp.state).toBe('connected');
      expect(result.whatsapp.user).toBe('59170000000');
    });

    it('incluye el diagnóstico de persistencia de la sesión', async () => {
      const result = await appController.health();
      expect(result.sesion).toEqual({
        persistente: false,
        path: './data/auth',
        detalle: 'WHATSAPP_SESSION_PATH no configurada',
      });
    });
  });
});
