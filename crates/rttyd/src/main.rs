use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::ws::Message;
use axum::http::{Response, StatusCode, Uri, header};
use axum::{Router, extract::WebSocketUpgrade, response::IntoResponse, routing::get};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use pty_process::Command;
use rtty::{CommandInputItem, CommandOutputItem, start_command};
use rust_embed::Embed;
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tracing::{info, warn};

#[tokio::main]
async fn main() {
    // initialize tracing
    tracing_subscriber::fmt::init();
    // Build the Axum application
    let app = Router::new()
        .route("/ws", get(move |ws: WebSocketUpgrade| handle_websocket(ws)))
        .fallback(get(static_handler));
    // Start the server
    let listener = TcpListener::bind("127.0.0.1:33080").await.unwrap();
    println!("Listening on http://127.0.0.1:33080");
    axum::serve(listener, app).await.unwrap();
}
async fn handle_websocket(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket))
}
async fn handle_socket(socket: axum::extract::ws::WebSocket) {
    let use_binary = true;
    let (mut tx, mut rx) = socket.split();
    let aborter = Arc::new(Notify::new());
    let (mut command_tx, mut command_rx) =
        start_command(Command::new("bash"), aborter.clone(), None).unwrap();
    loop {
        tokio::select! {
            msg = rx.next() => {
                if let Some(msg) = msg {
                    match msg {
                        Ok(msg) => {
                            match msg {
                                Message::Text(text) => {
                                    let text = text.to_string();
                                    if text.starts_with("0;") {
                                        let data = base64::engine::general_purpose::STANDARD.decode(text[2..].as_bytes()).unwrap();
                                        command_rx.send(CommandInputItem::Input(data)).await.unwrap();
                                    } else if text.starts_with("1;") {
                                        let data = text[2..].to_string();
                                        command_rx.send(CommandInputItem::InputString(data)).await.unwrap();
                                    } else if text.starts_with("2;") {
                                        let split = text.split(";").collect::<Vec<&str>>();
                                        let data = pty_process::Size::new(split[1].parse().unwrap(), split[2].parse().unwrap());
                                        command_rx.send(CommandInputItem::Resize(data)).await.unwrap();
                                    } else {
                                        warn!("Received message: {}", text);
                                    }
                                }
                                Message::Binary(data) => {
                                    command_rx.send(CommandInputItem::Input(data.to_vec())).await.unwrap();
                                }
                                Message::Close(_) => {
                                    aborter.notify_waiters();
                                    break;
                                }
                                Message::Ping(data) => {
                                    tx.send(Message::Pong(data)).await.unwrap();
                                }
                                Message::Pong(_) => (),
                            }
                        }
                        Err(e) => {
                            println!("Error: {}", e);
                            aborter.notify_waiters();
                            break;
                        }
                    }
                } else {
                    info!("Client closed, aborting command");
                    aborter.notify_waiters();
                    break;
                }
            }
            Some(output) = command_tx.next() => {
                match output {
                    CommandOutputItem::Output(output) => {
                        if use_binary {
                            tx.send(Message::Binary(output)).await.unwrap();
                        } else {
                            tx.send(Message::Text(format!("0;{}", base64::engine::general_purpose::STANDARD.encode(&output)).into())).await.unwrap();
                        }
                    }
                    CommandOutputItem::Error(error) => {
                        warn!("Error: {}", error);
                    }
                    CommandOutputItem::Exit(exit) => {
                        tx.send(Message::Text(format!("1;{}", exit).into())).await.unwrap();
                        break;
                    }
                }
            }
        }
    }
}

async fn static_handler(uri: Uri) -> impl IntoResponse {
    let mut path = PathBuf::from(uri.path().trim_start_matches("/"));

    if path.file_name() == None {
        path = path.join("index.html");
    }

    match Asset::get(path.to_str().unwrap()) {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            Response::builder()
                .header(header::CONTENT_TYPE, mime.as_ref())
                .body(String::from_utf8(content.data.to_vec()).unwrap())
                .unwrap()
        }
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body("Not Found".to_string())
            .unwrap(),
    }
}

#[derive(Embed)]
#[folder = "web/dist/"]
struct Asset;
