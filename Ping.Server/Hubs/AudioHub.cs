using Microsoft.AspNetCore.SignalR;

namespace Ping.Server.Hubs
{
    public class AudioHub : Hub
    {
        // Broadcast an entire voice note (byte[] of the audio file) to all others
        public async Task SendVoiceNote(byte[] data, string mimeType, string sender)
        {
            // Basic guardrails
            if (data == null || data.Length == 0) return;
            if (data.Length > 2 * 1024 * 1024) // 2 MB limit for PoC
                throw new HubException("Voice note too large for PoC (max 2 MB)");


            await Clients.Others.SendAsync("VoiceNote", data, mimeType, sender, DateTimeOffset.UtcNow);
        }
    }
}
