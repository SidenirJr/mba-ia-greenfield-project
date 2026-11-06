import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VideoStatus } from '../videos.constants';
import { numberTransformer } from './number.transformer';

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 11, unique: true })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Index()
  @Column({
    type: 'enum',
    enum: Object.values(VideoStatus),
    enumName: 'video_status',
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 255 })
  original_file_name: string;

  @Column({ type: 'varchar', length: 255 })
  content_type: string;

  @Column({ type: 'bigint', transformer: numberTransformer })
  size_bytes: number;

  @Column({ type: 'bigint', transformer: numberTransformer })
  part_size: number;

  @Column({ type: 'integer' })
  part_count: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  upload_expires_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  processing_started_at: Date | null;

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 3,
    nullable: true,
    transformer: numberTransformer,
  })
  duration_seconds: number | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  video_codec: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  container_format: string | null;

  @Column({ type: 'bigint', nullable: true, transformer: numberTransformer })
  bitrate_bps: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  error_code: string | null;

  @Column({ type: 'text', nullable: true })
  error_message: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
