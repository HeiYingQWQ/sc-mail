import { Module } from '@nestjs/common';
import { SystemMailSendersService } from './system-mail-senders.service';

@Module({
  providers: [SystemMailSendersService],
  exports: [SystemMailSendersService],
})
export class SystemMailSendersModule {}
