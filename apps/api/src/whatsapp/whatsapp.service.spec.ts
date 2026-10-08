import { AssistantService } from '../assistant/assistant.service';
import { AllowlistService } from './allowlist.service';
import { WhatsappService } from './whatsapp.service';

type Sock = {
  sendMessage: jest.Mock;
  signalRepository: {
    lidMapping: { getPNForLID: jest.Mock };
  };
};

describe('WhatsappService - resolución de remitente LID', () => {
  const build = (
    pn: string | null,
  ): {
    service: WhatsappService;
    assistant: { enabled: boolean; reply: jest.Mock };
    sock: Sock;
  } => {
    const assistant = {
      enabled: true,
      reply: jest.fn().mockResolvedValue('respuesta'),
    };
    const allowlist = {
      allowed: () => ['59169395624'],
    } as unknown as AllowlistService;

    const service = new WhatsappService(
      assistant as unknown as AssistantService,
      allowlist,
    );

    const sock: Sock = {
      sendMessage: jest.fn().mockResolvedValue({}),
      signalRepository: {
        lidMapping: { getPNForLID: jest.fn().mockResolvedValue(pn) },
      },
    };

    (service as unknown as { state: string }).state = 'connected';
    (service as unknown as { sock: Sock }).sock = sock;

    return { service, assistant, sock };
  };

  const directMessage = (
    remoteJid: string,
    remoteJidAlt?: string,
  ): unknown => ({
    key: { remoteJid, remoteJidAlt, fromMe: false, id: 'ABC' },
    message: { conversation: 'hola' },
    messageTimestamp: 1,
  });

  it('usa remoteJidAlt (@s.whatsapp.net) para la allowlist', async () => {
    const { service, assistant, sock } = build(null);

    await (
      service as unknown as { onMessages: (m: unknown[]) => Promise<void> }
    ).onMessages([
      directMessage('192810040950927@lid', '59169395624@s.whatsapp.net'),
    ]);

    expect(assistant.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '59169395624@s.whatsapp.net',
        fromNumber: '59169395624',
      }),
    );
    expect(sock.sendMessage).toHaveBeenCalledWith(
      '59169395624@s.whatsapp.net',
      { text: 'respuesta' },
    );
  });

  it('resuelve LID->PN con lidMapping cuando no hay remoteJidAlt', async () => {
    const { service, assistant } = build('59169395624@s.whatsapp.net');

    await (
      service as unknown as { onMessages: (m: unknown[]) => Promise<void> }
    ).onMessages([directMessage('192810040950927@lid')]);

    expect(assistant.reply).toHaveBeenCalledWith(
      expect.objectContaining({ fromNumber: '59169395624' }),
    );
  });

  it('ignora un LID sin mapping ni telefono en la allowlist', async () => {
    const { service, assistant } = build(null);

    await (
      service as unknown as { onMessages: (m: unknown[]) => Promise<void> }
    ).onMessages([directMessage('192810040950927@lid')]);

    expect(assistant.reply).not.toHaveBeenCalled();
  });

  it('ignora los mensajes propios (fromMe)', async () => {
    const { service, assistant } = build(null);

    await (
      service as unknown as { onMessages: (m: unknown[]) => Promise<void> }
    ).onMessages([
      {
        key: {
          remoteJid: '117673715359790@lid',
          remoteJidAlt: '59169395624@s.whatsapp.net',
          fromMe: true,
          id: 'OWN',
        },
        message: { conversation: 'texto propio' },
        messageTimestamp: 1,
      },
    ]);

    expect(assistant.reply).not.toHaveBeenCalled();
  });
});
