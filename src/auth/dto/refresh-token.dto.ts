import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshTokenDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1Ni...' })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}
