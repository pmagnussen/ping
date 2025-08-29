using Ping.Server.Hubs;

var builder = WebApplication.CreateBuilder(args);

// Add services
builder.Services.AddControllersWithViews();
builder.Services.AddRazorPages();

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

builder.Services.AddSignalR(options =>
{
    options.EnableDetailedErrors = true;
    options.MaximumReceiveMessageSize = 2 * 1024 * 1024; // 2 MB
})
.AddMessagePackProtocol(); // <-- enable MessagePack

// Allow Vite origin for SignalR during dev
builder.Services.AddCors(o =>
{
    o.AddPolicy("dev", p =>
        p.WithOrigins("https://localhost:51520")
         .AllowAnyHeader()
         .AllowAnyMethod()
         .AllowCredentials());
});

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseHsts();
}

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseHttpsRedirection();
app.UseStaticFiles();
app.UseRouting();

app.UseCors();

app.MapRazorPages();
app.MapControllers();

app.MapHub<AudioHub>("/voice").RequireCors("dev");

app.MapFallbackToFile("index.html");

app.Run();