import { ArgumentsHost } from '@nestjs/common';
import { DomainExceptionFilter } from './domain-exception.filter';
import {
  EmailAlreadyExistsException,
  EmailNotConfirmedException,
  InvalidCredentialsException,
  InvalidTokenException,
  TokenExpiredException,
  TokenReuseDetectedException,
  VideoNotFoundException,
  ChannelNotFoundException,
  InvalidContentTypeException,
  UploadSizeExceedsLimitException,
  VideoNotInDraftException,
  UploadExpiredException,
  InvalidPartNumberException,
  InvalidUploadPartsException,
  UploadSizeMismatchException,
} from '../exceptions/domain.exception';

describe('DomainExceptionFilter', () => {
  let filter: DomainExceptionFilter;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new DomainExceptionFilter();
    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ json: mockJson });

    mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
        getRequest: () => ({ url: '/test', method: 'POST' }),
      }),
      getArgs: () => [],
      getArgByIndex: () => null,
      getType: () => 'http',
    } as unknown as ArgumentsHost;
  });

  it('maps EmailAlreadyExistsException to 409 with EMAIL_ALREADY_EXISTS', () => {
    filter.catch(new EmailAlreadyExistsException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(409);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 409,
      error: 'EMAIL_ALREADY_EXISTS',
      message: 'Email is already registered',
    });
  });

  it('maps InvalidCredentialsException to 401 with INVALID_CREDENTIALS', () => {
    filter.catch(new InvalidCredentialsException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'INVALID_CREDENTIALS',
      message: expect.any(String) as string,
    });
  });

  it('maps EmailNotConfirmedException to 403 with EMAIL_NOT_CONFIRMED', () => {
    filter.catch(new EmailNotConfirmedException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(403);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 403,
      error: 'EMAIL_NOT_CONFIRMED',
      message: expect.any(String) as string,
    });
  });

  it('maps InvalidTokenException to 401 with INVALID_TOKEN', () => {
    filter.catch(new InvalidTokenException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'INVALID_TOKEN',
      message: expect.any(String) as string,
    });
  });

  it('maps TokenExpiredException to 401 with TOKEN_EXPIRED', () => {
    filter.catch(new TokenExpiredException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'TOKEN_EXPIRED',
      message: expect.any(String) as string,
    });
  });

  it('maps TokenReuseDetectedException to 401 with TOKEN_REUSE_DETECTED', () => {
    filter.catch(new TokenReuseDetectedException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'TOKEN_REUSE_DETECTED',
      message: expect.any(String) as string,
    });
  });

  describe.each([
    [VideoNotFoundException, 404, 'VIDEO_NOT_FOUND', 'Video not found'],
    [ChannelNotFoundException, 404, 'CHANNEL_NOT_FOUND', 'Channel not found'],
    [
      InvalidContentTypeException,
      415,
      'INVALID_CONTENT_TYPE',
      'Content type must be a video type',
    ],
    [
      UploadSizeExceedsLimitException,
      413,
      'UPLOAD_SIZE_EXCEEDS_LIMIT',
      'Upload size exceeds the allowed limit',
    ],
    [
      VideoNotInDraftException,
      409,
      'VIDEO_NOT_IN_DRAFT',
      'Video is not in draft status',
    ],
    [UploadExpiredException, 410, 'UPLOAD_EXPIRED', 'Upload has expired'],
    [
      InvalidPartNumberException,
      400,
      'INVALID_PART_NUMBER',
      'Part number out of range',
    ],
    [
      InvalidUploadPartsException,
      400,
      'INVALID_UPLOAD_PARTS',
      'Uploaded parts are invalid',
    ],
    [
      UploadSizeMismatchException,
      409,
      'UPLOAD_SIZE_MISMATCH',
      'Uploaded size does not match the declared size',
    ],
  ])('video exceptions', (Exception, status, code, message) => {
    it(`maps ${Exception.name} to ${status} with ${code}`, () => {
      filter.catch(new Exception(), mockHost);

      expect(mockStatus).toHaveBeenCalledWith(status);
      expect(mockJson).toHaveBeenCalledWith({
        statusCode: status,
        error: code,
        message,
      });
    });
  });
});
