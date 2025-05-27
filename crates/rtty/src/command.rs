use std::{pin::Pin, sync::Arc};

use async_stream::stream;
use bytes::Bytes;
use futures_util::{Sink, Stream};
use pty_process::Size;
use tokio::{io::AsyncWriteExt, sync::Notify};
use tokio_stream::StreamExt;
use tokio_util::{io::ReaderStream, sync::PollSendError};
use tracing::{debug, error};

#[derive(Debug)]
pub enum CommandOutputItem {
    Output(Bytes),
    Error(String),
    Exit(String),
}

#[derive(Debug)]
pub enum CommandInputItem {
    Input(Vec<u8>),
    InputString(String),
    Resize(Size),
}

pub fn start_command(
    command: pty_process::Command,
    aborter: Arc<Notify>,
    size: Option<Size>,
) -> Result<
    (
        Pin<Box<dyn Stream<Item = CommandOutputItem> + Send>>,
        Pin<Box<dyn Sink<CommandInputItem, Error = PollSendError<CommandInputItem>> + Send>>,
    ),
    pty_process::Error,
> {
    let (pty, pts) = pty_process::open()?;

    if let Some(size) = size {
        pty.resize(size).ok();
    }

    let mut child = command.spawn(pts)?;
    let (pty_out, mut pty_in) = pty.into_split();
    let mut out_stream = ReaderStream::new(pty_out);
    let exited = Arc::new(Notify::new());
    let exited_clone = exited.clone();

    let stream = futures_util::StreamExt::boxed(stream! {
        loop {
            tokio::select! {
                Some(output) = out_stream.next() =>
                    match output {
                        Ok(b) => yield CommandOutputItem::Output(b.into()),
                        // workaround against PTY closing incorrect error handling
                        // see: https://stackoverflow.com/questions/72150987/why-does-reading-from-an-exited-pty-process-return-input-output-error-in-rust
                        Err(err) if err.to_string() == "Input/output error (os error 5)" => continue,
                        Err(err) => yield CommandOutputItem::Error(err.to_string()),
                    },
                status = child.wait() => {
                    match status {
                        Err(err) => yield CommandOutputItem::Error(err.to_string()),
                        Ok(status) => {
                            let code = status.code().unwrap_or(0);
                            yield CommandOutputItem::Exit(format!("Command exited with status code: {code}"));
                            exited_clone.notify_waiters();
                            break;
                        }
                    }
                },
                _ = aborter.notified() => {
                    match child.start_kill() {
                        Ok(()) => debug!("Command aborted"),
                        Err(err) => error!("Failed to abort command: {err}"),
                    };
                    yield CommandOutputItem::Exit("Aborted".to_string());
                    exited_clone.notify_waiters();
                    break;
                }
            }
        }
    });

    let (input_tx, mut input_rx) = tokio::sync::mpsc::channel::<CommandInputItem>(200);
    let input_sink = Box::pin(tokio_util::sync::PollSender::new(input_tx));

    tokio::spawn(async move {
        loop {
            tokio::select! {
              Some(input) = input_rx.recv() => {
                match input {
                  CommandInputItem::Input(input) => {
                    pty_in.write(&input).await.unwrap();
                  }
                  CommandInputItem::InputString(input) => {
                    pty_in.write(input.as_bytes()).await.unwrap();
                  }
                  CommandInputItem::Resize(size) => {
                    pty_in.resize(size).ok();
                  }
                }
              }
              _ = exited.notified() => {
                  break;
              }
            }
        }
    });

    Ok((stream, input_sink))
}
