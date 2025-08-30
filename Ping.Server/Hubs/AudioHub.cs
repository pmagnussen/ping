using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;

namespace Ping.Server.Hubs
{
    public record PeerInfo(string ConnectionId, string Name);

    public class AudioHub : Hub
    {
        private static readonly ConcurrentDictionary<string, string> Peers = new();

        // Existing PoC broadcast (kept for compatibility; no longer used by WebRTC path)
        public async Task SendVoiceNote(byte[] data, string mimeType, string sender)
        {
            if (data == null || data.Length == 0) return;
            if (data.Length > 2 * 1024 * 1024)
                throw new HubException("Voice note too large for PoC (max 2 MB)");

            await Clients.Others.SendAsync("VoiceNote", data, mimeType, sender, DateTimeOffset.UtcNow);
        }

        public override async Task OnConnectedAsync()
        {
            Peers[Context.ConnectionId] = "Guest";
            await Clients.Others.SendAsync("PeerJoined", Context.ConnectionId, "Guest");
            await base.OnConnectedAsync();
        }

        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            if (Peers.TryRemove(Context.ConnectionId, out _))
            {
                await Clients.Others.SendAsync("PeerLeft", Context.ConnectionId);
            }
            await base.OnDisconnectedAsync(exception);
        }

        public Task SetName(string name)
        {
            Peers[Context.ConnectionId] = string.IsNullOrWhiteSpace(name) ? "Guest" : name.Trim();
            return Clients.Others.SendAsync("PeerRenamed", Context.ConnectionId, Peers[Context.ConnectionId]);
        }

        public Task<List<PeerInfo>> GetPeers()
        {
            var list = Peers.Where(p => p.Key != Context.ConnectionId)
                            .Select(p => new PeerInfo(p.Key, p.Value))
                            .ToList();
            return Task.FromResult(list);
        }

        // WebRTC signaling
        public Task SendOffer(string targetConnectionId, string sdp, string fromName)
            => Clients.Client(targetConnectionId).SendAsync("RtcOffer", Context.ConnectionId, fromName, sdp);

        public Task SendAnswer(string targetConnectionId, string sdp)
            => Clients.Client(targetConnectionId).SendAsync("RtcAnswer", Context.ConnectionId, sdp);

        public Task SendIce(string targetConnectionId, string candidate)
            => Clients.Client(targetConnectionId).SendAsync("RtcIce", Context.ConnectionId, candidate);

        // NEW: simple talking indicator broadcast
        public Task SetTalking(bool talking)
        {
            var name = Peers.TryGetValue(Context.ConnectionId, out var n) ? n : "Guest";
            return Clients.Others.SendAsync("PeerTalking", Context.ConnectionId, name, talking);
        }
    }
}