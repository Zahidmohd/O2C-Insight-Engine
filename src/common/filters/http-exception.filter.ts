import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number;
    let message: string;
    let type: string;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      message =
        typeof exceptionResponse === 'string'
          ? exceptionResponse
          : (exceptionResponse as any).message || exception.message;
      type = 'HTTP_ERROR';
    } else {
      status = 500;
      message = 'Internal Server Error';
      type = 'INTERNAL_ERROR';
    }

    // Log the stack trace
    if (exception instanceof Error) {
      this.logger.error(
        `${request.method} ${request.url} → ${status}`,
        exception.stack,
      );
    } else {
      this.logger.error(
        `${request.method} ${request.url} → ${status}: ${String(exception)}`,
      );
    }

    response.status(status).json({
      success: false,
      error: {
        message,
        type,
      },
    });
  }
}
